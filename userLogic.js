import { cleanName } from "./contactLogic.js";

// The header's user button (section 59): pure.

// Initials for the avatar: the first letter of the first and of the last name ("Jo Tester" -> "JT", "Mary Ann Van
// Dyke" -> "MD"), one letter for a single name ("Jo" -> "J"), upper case. Runs of spaces count as one (cleanName). An
// empty name gives "" (the avatar shows a person icon).
export function initialsOf(name) {
  const clean = cleanName(name);
  if (!clean) return "";
  const words = clean.split(" ");
  const first = (w) => Array.from(w)[0] ?? "";
  const letters = words.length === 1 ? first(words[0]) : first(words[0]) + first(words.at(-1));
  return letters.toLocaleUpperCase();
}

// The name to show: the portal full name (one space between names), else the username, else "".
export const displayName = (fullName, username) => cleanName(fullName) || cleanName(username) || "";
