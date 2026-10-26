# A throwaway SSH machine for the Machines tests: sshd on port 22 (key auth
# only, for the user "dev"), tmux, git, and a fake `claude` that prints the
# real CLI's banner and turn footers. Built and started by
# scripts/ssh-test-host.cjs; nothing here reaches a real server.
FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server tmux git ca-certificates procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && useradd -m -s /bin/bash dev \
 && mkdir -p /home/dev/.ssh /home/dev/project \
 && chmod 700 /home/dev/.ssh \
 && echo "# project" > /home/dev/project/README.md \
 && chown -R dev:dev /home/dev \
 && printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers dev\n' > /etc/ssh/sshd_config.d/codara-test.conf
COPY fake-claude.sh /usr/local/bin/claude
RUN chmod 755 /usr/local/bin/claude
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
