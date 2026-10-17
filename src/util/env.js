// The environment a program started by this app may see.
//
// The access code travels to the app in FIRAS_CODE (the installers launch it that way). A program the app starts -
// a shell command, the installer, a clipboard helper, a permission tool - has no business with it, so every child
// process in src/ is started with `env: childEnv(...)`. A test (test/util/childenv-guard.test.js) searches src/ for
// a start that forgets it.

/**
 * The given environment without this app's own access code. Names are matched without regard to case (Windows keeps
 * the case it was given). The input is not changed.
 */
export function childEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) if (/^FIRAS_CODE$/i.test(key)) delete env[key];
  return env;
}
