# Landing page photographs

Empty on purpose. Every plate on the landing page is a slot waiting for a real
photograph; until one exists the slot renders an honest "photo to shoot" plate
carrying its brief.

## Adding one

**Drop a file in this directory named for its slot. That is the whole process —
there is no code to change.**

| Filename | Where it lands |
|---|---|
| `trade-electrical.*` | The trades band under the hero — shown while "Electrical" is lit |
| `trade-plumbing.*` | …while "Plumbing" is lit |
| `trade-roofing.*` | …while "Roofing" is lit |
| `trade-hvac.*` | …while "HVAC" is lit |
| `trade-appliance-repair.*` | …while "Appliance repair" is lit |
| `strip-1.*` | Truck doors open, first light |
| `strip-2.*` | Hands, scuffed phone, finished panel |
| `strip-3.*` | Kitchen table, 9pm, paperwork |

The band rotates through whichever `trade-*` photographs exist, highlighting the
matching word. A trade with no photograph still lists — it just sits out of the
rotation. With none of them present the whole band collapses to the slim strip.

Adding a sixth trade means adding it to `TRADES` in `Landing.tsx` as well; the
filename is `trade-` plus the name lowercased with spaces as hyphens.

`.jpg` `.jpeg` `.png` `.webp` `.avif` all work. Remove the file and the slot goes
back to its honest "photo to shoot" plate — the two states are interchangeable at
any time, and a missing file is never an error.

**No subdirectories.** The portal build is deliberately flat because
`src/portal/portalApi.ts` rejects any filename containing a path separator (the
same traversal guard `/admin` and `/board` use). Vite resolves this directory
with `import.meta.glob` and emits each file flat and content-hashed, e.g.
`photo-band-gZFHmBQm.png`.

## Alt text

The **band** photographs need none — they are `aria-hidden`, because the trade
names beside them are real text carrying the same meaning, and five alt strings
would only make a screen reader read five near-identical descriptions of pictures
that illustrate words already on the page.

The **strip** photographs do need it, and that is the one thing you must still edit.

## Alt text — the one thing you must still edit

Alt text lives in `web/portal/src/screens/Landing.tsx`, not in the filename,
because it describes what is *in* the photograph for someone who cannot see it —
which a filename cannot know. Each slot already carries alt written for the shot
its brief describes.

**If the photograph you drop in differs from its brief, update the alt to match**,
or the page describes an image that isn't there. Search for `STRIP` and for
`slot="photo-band"` in that file.

## The band shrinks when it is empty

With no `photo-band.*` file the band collapses to the trades strip alone — a slim solid
qualification bar. An empty plate at 460px tall is a page announcing it is unfinished; a
one-line "Built for electrical, plumbing, roofing, HVAC, appliance repair" band is a page
telling the reader who it is for. Drop the file in and it expands back to the full bleed.

Nothing else on the page does this — the three strip plates still render as honest plates,
because three small placeholders read as a deliberate grid where one enormous one reads as a hole.

## The photo band has one extra constraint

Its image sits under a dark scrim carrying the "Built for" trades strip, so it
must survive being darkened along its bottom edge. Avoid anything with its
subject low in the frame. Landscape, roughly 3:1 or wider, crops best.

## Licensing — read before adding anything

This is a commercial page. Use only:

- photographs we shot ourselves, or
- images under a licence permitting **commercial use without attribution**
  (the Unsplash and Pexels licences both do)

Do not paste in an image found through an image search. "It was on the internet"
is not a licence, and the exposure lands on the business, not the page.

## What actually works here

`DESIGN.md` §6 rules out stock photography as an interim option: a smiling man
in clean hi-vis reads as fake to this audience and costs more trust than an
empty plate buys. That rule is why these slots are empty rather than filled.

If a candidate image looks like an advert, it is the wrong image. What works:

- unposed, and doing the actual work
- dirty hands, worn tools, real wear on the truck
- real light — dawn, a work light, a kitchen at 9pm — not a studio
- faces incidental or out of frame; this is about the work, not the model
- American vehicles, outlets, panels and signage (the market is US)

An empty plate is a better placeholder than a wrong photograph. If in doubt,
leave the slot empty and shoot it properly.
