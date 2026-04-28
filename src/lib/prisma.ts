import { PrismaClient } from "@prisma/client";

const noDatabaseMessage =
  "Database is disabled in this app version. Use local dashboard state only.";

export const prisma = new Proxy(
  {},
  {
    get() {
      throw new Error(noDatabaseMessage);
    },
  },
) as PrismaClient;
