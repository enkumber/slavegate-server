require('dotenv').config();

module.exports = {
  apps: [
  {
    name: "redis",
    script: "scripts/start-redis.sh",
    cwd: __dirname,
    interpreter: "bash",
    autorestart: true,
    watch: false,
    env: {}
  },
  {
    name: "phone-network-server",
    script: "dist/phone-network-server/src/index.js",
    cwd: __dirname,
    env: {
      NODE_ENV: "production",
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) =>
          ["ANTHROPIC_API_KEY","API_KEY","BASE_URL","DATABASE_URL","REDIS_URL",
           "DASHBOARD_DIST","APK_PATH","BRAVE_API_KEY","OLLAMA_API_KEY",
           "AGENT_PLANNER_MODEL","AGENT_EXECUTOR_MODEL","AGENT_VERIFIER_MODEL",
           "AGENT_EXECUTOR_LOOKAHEAD","OPENCLAW_GATEWAY_TOKEN","OPENCLAW_GATEWAY_URL"].includes(k) && process.env[k]
        )
      )
    }
  }]
};
