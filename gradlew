#!/bin/sh
# Gradle wrapper script for Unix

APP_NAME="Gradle"
APP_BASE_NAME=$(basename "$0")

# Resolve links
PRG="$0"
while [ -h "$PRG" ]; do
  ls=$(ls -ld "$PRG")
  link=$(expr "$ls" : '.*-> \(.*\)$')
  if expr "$link" : '/.*' > /dev/null; then PRG="$link"
  else PRG=$(dirname "$PRG")"/$link"
  fi
done
SAVED="$(pwd)"
APP_HOME="$(cd "$(dirname "$PRG")/"; pwd -P)"
cd "$SAVED"

CLASSPATH="$APP_HOME/gradle/wrapper/gradle-wrapper.jar"

# Java opts
DEFAULT_JVM_OPTS='-Xmx64m -Xms64m'
JAVA_OPTS="${JAVA_OPTS:-}"
GRADLE_OPTS="${GRADLE_OPTS:-}"

# Find java
if [ -n "$JAVA_HOME" ]; then
  JAVACMD="$JAVA_HOME/bin/java"
else
  JAVACMD="java"
fi
if ! command -v "$JAVACMD" > /dev/null 2>&1; then
  echo "ERROR: JAVA_HOME not set and no 'java' command found." >&2
  exit 1
fi

exec "$JAVACMD" \
  $DEFAULT_JVM_OPTS \
  $JAVA_OPTS \
  $GRADLE_OPTS \
  "-Dorg.gradle.appname=$APP_BASE_NAME" \
  -classpath "$CLASSPATH" \
  org.gradle.wrapper.GradleWrapperMain "$@"
