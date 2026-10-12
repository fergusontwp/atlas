// White flattening before JPEG encoding. Pure pixels; the capture adapter handles canvas/toBlob.
export function flattenOnWhite(rgba) {
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.length % 4) {
    throw new Error("Invalid print image pixels.");
  }
  const result = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] / 255;
    for (let channel = 0; channel < 3; channel++) result[i + channel] = Math.round(rgba[i + channel] * alpha + 255 * (1 - alpha));
    result[i + 3] = 255;
  }
  return result;
}
