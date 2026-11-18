# Maths solver sidecar (PD-07). UNTESTED in the dev environment (Docker unavailable there).
#
# Run with no outbound network and a read-only filesystem, e.g.
#   docker build -t ekbharat/math-solver services/math-solver
#   docker network create --internal math-internal          # no route to the outside world
#   docker run --rm --read-only --network math-internal --cap-drop ALL \
#     --security-opt no-new-privileges --pids-limit 64 --memory 1g --cpus 1 \
#     ekbharat/math-solver
# The API joins the same internal network and calls http://math-solver:8765.
# (As a Kubernetes sidecar, bind 127.0.0.1 instead and deny egress with a NetworkPolicy.)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONHASHSEED=0
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir --disable-pip-version-check --require-hashes --only-binary=:all: --no-deps -r requirements.txt \
 && python -m compileall -q /usr/local/lib/python3.12
COPY solver ./solver
RUN useradd --system --uid 10001 --no-create-home solver
USER 10001
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=2).status == 200 else 1)"
CMD ["python", "-m", "solver.server", "--host", "0.0.0.0", "--port", "8765", "--allow-non-loopback", "--workers", "2", "--timeout", "2"]
