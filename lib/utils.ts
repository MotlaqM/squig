import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// ---------------------------------------------------------------------------
// The chrome scale (see app/globals.css) adds custom values to Tailwind's own
// namespaces, and tailwind-merge has to be told they exist — it can only merge
// classes it recognises.
//
// This matters most for `text-*`, which carries BOTH font size and colour. An
// unregistered `text-label` gets filed as a colour, so the moment a real colour
// follows it in the same cn() call the size is dropped as a conflict:
// cn("text-label text-muted-foreground") emitted only the colour, and every
// label and note in the inspector quietly fell back to the browser's 16px while
// the handful written as plain strings rendered correctly. A size scale that
// silently applies in some places and not others is worse than no scale.
//
// The spacing groups matter for a subtler reason: overriding size-ctl with
// size-ctl-sm (the align cluster does exactly that) only works if both are
// known to be the same group, otherwise both survive and stylesheet order —
// not the caller — decides which wins.
// ---------------------------------------------------------------------------

const CHROME_RADII = ["chrome-xs", "chrome-sm", "chrome-md", "chrome-lg"]
const CHROME_SPACING = ["ctl", "ctl-sm", "ctl-lg", "gutter", "row", "label"]

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["micro", "label", "row", "title"] }],
      rounded: [{ rounded: CHROME_RADII }],
      "rounded-t": [{ "rounded-t": CHROME_RADII }],
      shadow: [{ shadow: ["panel", "popup"] }],
      w: [{ w: CHROME_SPACING }],
      h: [{ h: CHROME_SPACING }],
      size: [{ size: CHROME_SPACING }],
      p: [{ p: CHROME_SPACING }],
      px: [{ px: CHROME_SPACING }],
      py: [{ py: CHROME_SPACING }],
      pt: [{ pt: CHROME_SPACING }],
      pb: [{ pb: CHROME_SPACING }],
      gap: [{ gap: CHROME_SPACING }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
