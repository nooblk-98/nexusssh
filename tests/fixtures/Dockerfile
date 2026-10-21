FROM alpine:3.22
RUN apk add --no-cache openssh bash coreutils procps && adduser -D -s /bin/bash nexus && echo 'nexus:nexus-fixture-only-password' | chpasswd && ssh-keygen -A && mkdir -p /run/sshd /home/nexus/files /home/nexus/.ssh && ssh-keygen -t ed25519 -N '' -f /home/nexus/.ssh/test_key && cp /home/nexus/.ssh/test_key.pub /home/nexus/.ssh/authorized_keys && chmod 700 /home/nexus/.ssh && chmod 600 /home/nexus/.ssh/authorized_keys && chown -R nexus:nexus /home/nexus && echo 'fixture content' > /home/nexus/files/example.txt && chown nexus:nexus /home/nexus/files/example.txt && ln -s /etc /home/nexus/files/escape
RUN printf 'PasswordAuthentication yes\nPermitRootLogin no\nAllowUsers nexus\nSubsystem sftp internal-sftp\n' > /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
