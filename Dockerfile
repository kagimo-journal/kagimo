# The server as a container image (README "Running it yourself"). The places dataset
# (frontend/public/places/places.v1.json) is copied in if it exists locally; run
# `make places` first, otherwise entries just get no location.
#
# The base images are pinned by digest (the multi-platform index each tag pointed at on
# 2026-11-14), so a build always starts from the same bytes even if a tag is re-pushed.
# To update one: `docker buildx imagetools inspect node:22-alpine` (etc.) prints the
# current digest; change the tag and the digest together.

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
COPY backend/web/ /src/backend/web/
RUN npm run build

FROM golang:1.27-alpine@sha256:eb61c3873c97416fff0116553fff65d67a3549f72e11d9758849a689cdd8b523 AS backend
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
COPY --from=frontend /src/backend/web/dist/ ./web/dist/
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /journal ./cmd/journal

FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
# sqlite: online backups from inside the container; su-exec: drop root after fixing volume perms.
RUN apk add --no-cache sqlite su-exec ca-certificates \
 && addgroup -S journal && adduser -S -G journal -H -h /data journal
COPY --from=backend /journal /usr/local/bin/journal
COPY deploy/docker-entrypoint.sh /usr/local/bin/entrypoint
ENV JOURNAL_ADDR=0.0.0.0:8080 JOURNAL_DATA=/data
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint"]
