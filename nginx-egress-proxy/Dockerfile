FROM nginx:1.30.6-alpine@sha256:c59d1f8b1e0e42da75be973424cd72e23f7f8adfb54e982f4d1cd0216a5a5576

# Clerum remote MCP egress proxy image.
# The upstream nginx image provides the /etc/nginx/templates envsubst entrypoint
# behavior HCC relies on; this layer makes it safe to run as the nginx user.
#
# This layer also carries the stderr log filter (#1240). The remote baseUrl
# query can hold a credential, and NGINX prints the full upstream URL in every
# upstream error line. egress-proxy-entrypoint keeps NGINX as PID 1 and routes
# only stderr through egress-proxy-log-filter; egress-proxy-liveness is the exec
# liveness probe that makes a dead filter a visible container restart.
# egress-proxy-template-check refuses to start when a value that envsubst will
# insert into a template would change the NGINX syntax around it.
COPY egress-proxy-entrypoint /usr/local/bin/egress-proxy-entrypoint
COPY egress-proxy-log-filter /usr/local/bin/egress-proxy-log-filter
COPY egress-proxy-liveness /usr/local/bin/egress-proxy-liveness
COPY egress-proxy-template-check /usr/local/bin/egress-proxy-template-check

RUN set -eux; \
    chmod 0755 /usr/local/bin/egress-proxy-entrypoint /usr/local/bin/egress-proxy-liveness; \
    chmod 0644 /usr/local/bin/egress-proxy-log-filter /usr/local/bin/egress-proxy-template-check; \
    rm -f /etc/nginx/conf.d/default.conf; \
    sed -i '/^user[[:space:]]/d; s|pid[[:space:]].*;|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf; \
    mkdir -p /etc/nginx/templates /etc/nginx/conf.d /var/cache/nginx /var/run/nginx /tmp/client_temp /tmp/proxy_temp; \
    chown -R 101:101 /etc/nginx /var/cache/nginx /var/run/nginx /tmp/client_temp /tmp/proxy_temp

USER 101:101
EXPOSE 3000
# The wrapper execs the official /docker-entrypoint.sh, which execs this CMD.
# CMD must be repeated: declaring ENTRYPOINT in a child image resets the base
# image CMD to empty, and the official entrypoint would then exec nothing and
# exit 0.
ENTRYPOINT ["/usr/local/bin/egress-proxy-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
