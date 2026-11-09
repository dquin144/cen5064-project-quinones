// Domain tier: the rules for accounts (pure functions, no I/O, imports nothing).

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200; // hashing very long input is slow; nobody needs more

// Creating an account. Returns { username, password, errors }; an empty errors
// object means the input is valid. The username is trimmed; the password isn't
// (spaces in a password are the user's choice).
function validateNewAccount(input) {
  const username = String(input?.username ?? '').trim();
  const password = String(input?.password ?? '');
  const errors = {};
  if (!USERNAME_PATTERN.test(username)) {
    errors.username = 'Use 3–32 letters, numbers, dots, dashes or underscores.';
  }
  if (password.length < MIN_PASSWORD) {
    errors.password = `Use at least ${MIN_PASSWORD} characters.`;
  } else if (password.length > MAX_PASSWORD) {
    errors.password = `Use at most ${MAX_PASSWORD} characters.`;
  } else if (password.toLowerCase() === username.toLowerCase()) {
    errors.password = "Your password can't be your username.";
  }
  return { username, password, errors };
}

// Logging in: only checks that both fields were filled in, so the login form
// doesn't reveal the rules for new accounts (or whether an account exists).
function validateLogin(input) {
  const username = String(input?.username ?? '').trim();
  const password = String(input?.password ?? '');
  const errors = {};
  if (!username) errors.username = 'Enter your username.';
  if (!password) errors.password = 'Enter your password.';
  else if (password.length > MAX_PASSWORD) errors.password = 'Incorrect username or password.';
  return { username, password, errors };
}

module.exports = { validateNewAccount, validateLogin };
