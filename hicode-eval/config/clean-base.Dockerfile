FROM {{bun}} AS bun
FROM {{node}} AS node
FROM {{python}} AS python
FROM {{uv}} AS uv
FROM {{system}}
USER root
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=python /usr/local /opt/python313
COPY --from=uv /uv /usr/local/bin/uv
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash bubblewrap ca-certificates curl file git iproute2 jq libstdc++6 procps \
    python3 python3-venv ripgrep socat sqlite3 sudo tmux tzdata xxd \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s bun /usr/local/bin/bunx \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && usermod --login node --home /home/node --move-home ubuntu \
    && groupmod --new-name node ubuntu \
    && mkdir -p /eval /app /testbed /tests /logs/verifier /opt/hicode-eval /opt/hicode/releases /opt/hicode-swe/env /opt/hicode-environment
RUN /opt/python313/bin/python3.13 -m pip install --no-cache-dir --force-reinstall pip==25.2 \
    && /opt/python313/bin/python3.13 -m venv /opt/hicode-verifier \
    && /opt/hicode-verifier/bin/pip install --no-cache-dir pytest==8.4.1 pytest-json-ctrf==0.3.5 \
    && /opt/python313/bin/python3.13 -m venv /opt/hicode-swe/grader \
    && /opt/hicode-swe/grader/bin/pip install --no-cache-dir swebench==4.1.0
COPY package.json bun.lock /opt/hicode/
RUN cd /opt/hicode && bun install --production --frozen-lockfile \
    && dpkg-query -W > /opt/hicode-environment/system-packages.txt \
    && /opt/hicode-verifier/bin/pip freeze --all > /opt/hicode-environment/verifier-requirements.txt \
    && /opt/hicode-swe/grader/bin/pip freeze --all > /opt/hicode-environment/grader-requirements.txt
ENV UV_PYTHON_INSTALL_DIR=/opt/hicode-swe/python UV_NO_PROGRESS=1 SHELL=/bin/bash
WORKDIR /eval
CMD ["sleep", "infinity"]
