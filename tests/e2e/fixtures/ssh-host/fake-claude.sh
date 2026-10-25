#!/bin/bash
# Stands in for Claude Code: logs each launch, prints the banner Studio
# recognizes, and answers every prompt line with a short turn whose footer
# matches the real CLI's "working" frames.
printf '%s %s\n' "$$" "$*" >> /tmp/claude-launches.log
printf 'Claude Code v2.1.261\r\n'
printf '\xe2\x9d\xaf \r\n? for shortcuts\r\n'
while IFS= read -r line; do
  [ "$line" = "/exit" ] && { printf 'Goodbye!\r\n'; exit 0; }
  for s in 1 2 3; do
    printf '\xe2\x9c\xbb Pondering\xe2\x80\xa6 (%ss \xc2\xb7 \xe2\x86\x93 %s tokens)\r\n' "$s" "$((s * 7))"
    sleep 1
  done
  printf 'Done: %s\r\n\xe2\x9d\xaf \r\n' "$line"
done
