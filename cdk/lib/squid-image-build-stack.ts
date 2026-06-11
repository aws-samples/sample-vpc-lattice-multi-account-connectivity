import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import * as path from 'path';

export interface SquidImageBuildStackProps extends cdk.StackProps {
  /** ECR repository name for the Squid proxy image. */
  repositoryName?: string;
  /** SSM parameter path to publish the built image URI under. */
  imageUriSsmPath?: string;
}

/**
 * SquidImageBuildStack (Network account)
 *
 * Builds the custom Squid proxy container image in the cloud with CodeBuild
 * (correct linux/amd64 arch, no local Docker) and pushes it to ECR. The build
 * context (Dockerfile, squid.conf, allowlist.txt, entrypoint.sh) is uploaded
 * from `cdk/squid/` as a CodeBuild S3 source asset, so the build is fully
 * reproducible from this repository with no external Git connection.
 *
 * The custom image bakes in the FQDN allowlist (squid.conf:
 * `acl allowlist dstdomain "/etc/squid/allowlist.txt"` + `http_access deny all`),
 * which the stock ubuntu/squid image does not enforce.
 */
export class SquidImageBuildStack extends cdk.Stack {
  public readonly repositoryUri: string;

  constructor(scope: Construct, id: string, props: SquidImageBuildStackProps = {}) {
    super(scope, id, props);

    const repositoryName = props.repositoryName ?? 'apg-lattice-squid-proxy';
    const imageUriSsmPath = props.imageUriSsmPath ?? '/apg-lattice/egress/squid-image-uri';

    const repo = new ecr.Repository(this, 'SquidRepo', {
      repositoryName,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      lifecycleRules: [{ maxImageCount: 5, description: 'Keep only the last 5 images' }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
    this.repositoryUri = repo.repositoryUri;

    const buildLogGroup = new logs.LogGroup(this, 'BuildLogs', {
      logGroupName: `/aws/codebuild/${repositoryName}-build`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Upload cdk/squid/ as the CodeBuild source (zipped to S3 by CDK).
    const sourceAsset = new s3assets.Asset(this, 'SquidSource', {
      path: path.join(__dirname, '..', 'squid'),
    });

    const project = new codebuild.Project(this, 'SquidBuildProject', {
      projectName: `${repositoryName}-build`,
      description: 'Builds the Squid proxy image and pushes it to ECR',
      timeout: cdk.Duration.minutes(15),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true, // required for docker build
      },
      environmentVariables: {
        ECR_REPO_URI: { value: repo.repositoryUri },
        AWS_ACCOUNT_ID: { value: this.account },
        IMAGE_URI_SSM_PATH: { value: imageUriSsmPath },
      },
      source: codebuild.Source.s3({
        bucket: sourceAsset.bucket,
        path: sourceAsset.s3ObjectKey,
      }),
      logging: { cloudWatch: { logGroup: buildLogGroup } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
              'IMAGE_TAG=$(date +%Y%m%d-%H%M%S)',
            ],
          },
          build: {
            commands: [
              'echo Building the Squid image...',
              'docker build -t $ECR_REPO_URI:$IMAGE_TAG -f Dockerfile .',
            ],
          },
          post_build: {
            commands: [
              'echo Pushing the image...',
              'docker push $ECR_REPO_URI:$IMAGE_TAG',
              'echo Writing image URI to SSM...',
              'aws ssm put-parameter --name $IMAGE_URI_SSM_PATH --type String --overwrite --value $ECR_REPO_URI:$IMAGE_TAG',
              'echo Done - $ECR_REPO_URI:$IMAGE_TAG',
            ],
          },
        },
      }),
    });

    repo.grantPullPush(project);
    sourceAsset.grantRead(project);

    project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${imageUriSsmPath}`],
    }));

    // Seed the SSM parameter so dependent stacks can resolve it before first build.
    new ssm.StringParameter(this, 'ImageUriParam', {
      parameterName: imageUriSsmPath,
      stringValue: `${repo.repositoryUri}:bootstrap`,
      description: 'APG Lattice Squid proxy image URI (updated by CodeBuild)',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', { value: repo.repositoryUri });
    new cdk.CfnOutput(this, 'CodeBuildProjectName', { value: project.projectName });
    new cdk.CfnOutput(this, 'BuildCommand', {
      value: `aws codebuild start-build --project-name ${project.projectName} --region ${this.region}`,
    });

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-CB4',
        reason: 'CodeBuild builds a public Squid container image; KMS encryption of build artifacts is not required.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'ECR GetAuthorizationToken and CodeBuild log/report permissions require wildcard resources per AWS documentation.',
      },
    ]);
  }
}
