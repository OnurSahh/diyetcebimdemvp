import { spawnSync } from "node:child_process";

function pickDatabaseUrl() {
  return (
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    ""
  );
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env,
  });

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
}

const databaseUrl = pickDatabaseUrl();

if (!databaseUrl) {
  console.error(
    "Missing database env. Set POSTGRES_URL_NON_POOLING, POSTGRES_PRISMA_URL, POSTGRES_URL, or DATABASE_URL.",
  );
  process.exit(1);
}

if (databaseUrl.startsWith("file:")) {
  console.error("Invalid DATABASE_URL for Vercel. Use a Postgres URL, not file:./dev.db");
  process.exit(1);
}

const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
};

run("prisma", ["generate"], env);
run("prisma", ["db", "push"], env);
run("next", ["build"], env);
