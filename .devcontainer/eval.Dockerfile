ARG HICODE_EVAL_BASE=hicode-ubuntu:dev
FROM python:3.13-slim-bookworm AS evaluation_python
FROM ${HICODE_EVAL_BASE}
USER root
COPY --from=evaluation_python /usr/local /opt/python313
RUN if ! command -v tmux >/dev/null; then apt-get update && apt-get install -y --no-install-recommends tmux && rm -rf /var/lib/apt/lists/*; fi
RUN /opt/python313/bin/python3.13 -m venv /opt/hicode-verifier \
    && /opt/hicode-verifier/bin/pip install --no-cache-dir pytest==8.4.1 pytest-json-ctrf==0.3.5 \
    && mkdir -p /eval /app /tests /logs/verifier /opt/hicode-eval /opt/hicode/releases
WORKDIR /eval
CMD ["sleep", "infinity"]
