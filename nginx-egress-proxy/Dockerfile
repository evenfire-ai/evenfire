FROM nginx:1.30.6-alpine@sha256:c59d1f8b1e0e42da75be973424cd72e23f7f8adfb54e982f4d1cd0216a5a5576

# Clerum remote MCP egress proxy image.
# The upstream nginx image provides the /etc/nginx/templates envsubst entrypoint
# behavior HCC relies on; this layer makes it safe to run as the nginx user.
RUN set -eux; \
    rm -f /etc/nginx/conf.d/default.conf; \
    sed -i '/^user[[:space:]]/d; s|pid[[:space:]].*;|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf; \
    mkdir -p /etc/nginx/templates /etc/nginx/conf.d /var/cache/nginx /var/run/nginx /tmp/client_temp /tmp/proxy_temp; \
    chown -R 101:101 /etc/nginx /var/cache/nginx /var/run/nginx /tmp/client_temp /tmp/proxy_temp

USER 101:101
EXPOSE 3000
