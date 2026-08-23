# Landing page photographs

Empty on purpose. Every plate on the landing page is a slot waiting for a real
photograph; until one exists the slot renders an honest "photo to shoot" plate
carrying its brief.

## Adding one

1. Drop the file in this directory. **No subdirectories** — the portal build is
   deliberately flat because `src/portal/portalApi.ts` rejects any filename
   containing a path separator (the same traversal guard `/admin` and `/board`
   use). Importing through Vite is what keeps the emitted name flat and
   content-hashed.
2. Import it in `web/portal/src/screens/Landing.tsx`:
   ```ts
   import truckDoors from '../photos/truck-doors.jpg';
   ```
3. Pass it to the slot:
   ```tsx
   <PhotoPlate brief="Truck doors open, first light" src={truckDoors} alt="…" />
   ```

`alt` is required with `src`, and it is **not** the shot brief — it describes
what is in the photograph, for someone who cannot see it.

## The briefs still open

| Slot | Brief |
|---|---|
| Photo band (under the hero) | Electrician mid-job, phone in hand, open breaker panel behind |
| Strip 1 | Truck doors open, first light |
| Strip 2 | Hands, scuffed phone, finished panel |
| Strip 3 | Kitchen table, 9pm, paperwork |

The photo band's image sits under a dark scrim carrying the "Built for" trades
strip, so **it must be a photograph that survives being darkened at the bottom
edge** — avoid anything with its subject low in the frame.

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
