FROM public.ecr.aws/lts/ubuntu:20.04_stable

ENV SQUID_CACHE_DIR=/var/spool/squid \
    SQUID_LOG_DIR=/var/log/squid \
    SQUID_USER=proxy

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends squid && \
    rm -rf /var/lib/apt/lists/*

# Workaround for https://github.com/moby/moby/issues/31243
RUN usermod -a -G tty proxy

# Create dirs with correct ownership at build time
RUN mkdir -p ${SQUID_CACHE_DIR} ${SQUID_LOG_DIR} && \
    chown -R ${SQUID_USER}:${SQUID_USER} ${SQUID_CACHE_DIR} ${SQUID_LOG_DIR}

COPY entrypoint.sh /sbin/entrypoint.sh
RUN chmod 755 /sbin/entrypoint.sh

COPY squid.conf /etc/squid/squid.conf
COPY allowlist.txt /etc/squid/allowlist.txt

EXPOSE 3128/tcp
USER proxy
ENTRYPOINT ["/sbin/entrypoint.sh"]
