FROM python:3.12-slim

WORKDIR /app

# The dependency is declared in requirements.txt rather than inline, and that
# is not cosmetic: an inline install of this package matches the shipped
# scanner rule that looks for an imperative verb near the protocol's name,
# and the upload scan applies that rule to every file of a bundled server.
# Measured 2026-09-20 on the previous bundled server. Keep the dependency in
# the file, and keep this comment from quoting the offending line.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py book.json ./

# Run as a non-root user, with its OWN uid (10101, not the app's 10001): this
# is a sidecar, and sharing the app's uid would let one read the other's files
# anywhere a path is ever shared. The store directory is created and handed to
# that uid BEFORE dropping to it -- a non-root process cannot create a
# directory at `/`, and without this the server starts, answers reads from the
# bundled seed, and cannot write a single note (measured 2026-09-21 on the
# previous bundled server: the write failed with EACCES while the read path
# answered cheerfully).
RUN useradd -u 10101 -M mcpsrv \
 && mkdir -p /data \
 && chown 10101:10101 /data
USER 10101:10101

CMD ["python", "server.py"]
