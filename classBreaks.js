// Pure helpers for the natural-breaks symbology presets (no DOM, no SDK). styles.js asks the SDK for the breaks and
// these functions turn them into the class labels and the renderer the parcel layer draws. The labels are written
// here, not taken from the SDK, so they read as plain dollars and sensible numbers.

const group = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 10 });

// One break value as text. "currency": whole dollars with thousands separators ($97,480). "number": three significant
// digits, no trailing zeros, no exponent (0.214, 1.1, 1,230).
export function formatBreakValue(value, format) {
  if (format === "currency") {
    const dollars = Math.round(value);
    return `${dollars < 0 ? "-" : ""}$${group(Math.abs(dollars))}`;
  }
  return group(Number(Number(value).toPrecision(3)));
}

// The class label from a class's own min and max. A class takes values above its lower break up to and including its
// upper one (the first class starts at the lowest value), so for whole dollars the lower end of every class after the
// first is shown one dollar up: "$0 to $97,480", "$97,481 to $202,294". A class that holds a single dollar value is
// just that value.
export function classLabel(min, max, format, { first = false } = {}) {
  if (format === "currency") {
    const lo = first ? Math.round(min) : Math.floor(min) + 1;
    const hi = Math.round(max);
    return lo >= hi ? formatBreakValue(hi, format) : `${formatBreakValue(lo, format)} to ${formatBreakValue(hi, format)}`;
  }
  const lo = formatBreakValue(min, format);
  const hi = formatBreakValue(max, format);
  return lo === hi ? hi : `${lo} to ${hi}`;
}

// The renderer JSON for a natural-breaks preset. `infos` are the SDK's class breaks ({ minValue, maxValue }, in order),
// `colors` the ramp (the first `infos.length` colors are used, darkest last when fewer classes came back, so the ramp
// is sampled evenly rather than cut off), `fill` makes a symbol from a color and `noData` is the default symbol that
// draws null values.
export function breaksRenderer({ field, title, format, colors, infos, fill, noData }) {
  if (!Array.isArray(infos) || infos.length === 0) throw new Error(`No values to classify in ${field}.`);
  const n = infos.length;
  const pick = (i) => colors[n === 1 ? colors.length - 1 : Math.round((i * (colors.length - 1)) / (n - 1))];
  return {
    type: "class-breaks",
    field,
    legendOptions: { title },
    defaultSymbol: fill(noData),
    defaultLabel: "No data",
    classBreakInfos: infos.map((info, i) => ({
      minValue: info.minValue,
      maxValue: info.maxValue,
      label: classLabel(info.minValue, info.maxValue, format, { first: i === 0 }),
      symbol: fill(pick(i)),
    })),
  };
}
