/**
 * Settings from the environment. The project was called "z21-web" before; installations from that time still carry
 * their variables with the old prefix, so `Z21_<NAME>` keeps working wherever `OPENSTELLWERK_<NAME>` is not set.
 */
export function setting(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`OPENSTELLWERK_${name}`] ?? env[`Z21_${name}`];
}
