// Saves a file from the browser: a Blob, a temporary object URL on an anchor with the download attribute, and the URL
// revoked afterward. Desktop Chrome and Edge.
export function saveFile(data, filename, type) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000); // after the browser has started the download
}
