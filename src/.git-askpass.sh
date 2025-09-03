#!/bin/sh
case "$1" in
*Username*) printf 'x-access-token\n' ;;
*Password*) printf '%s\n' "$GIT_ASKPASS_TOKEN" ;;
*) printf '\n' ;;
esac
