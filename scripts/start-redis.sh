#!/bin/bash
# Redis startup script for Phone Network Server
# Uses Homebrew-installed redis-server (no daemonize — PM2 manages the process)
exec /home/linuxbrew/.linuxbrew/bin/redis-server --port 6379 --save "" --loglevel notice
