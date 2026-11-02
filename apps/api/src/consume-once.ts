import type { IRedisClient } from "bullmq";
export async function consumeOnce(
  client: IRedisClient,
  key: string,
  expected: string,
) {
  client.defineCommand("nexusConsumeOnce", {
    numberOfKeys: 1,
    lua: "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]); return 1 end; return 0",
  });
  return (await client.runCommand("nexusConsumeOnce", [key, expected])) === 1;
}
