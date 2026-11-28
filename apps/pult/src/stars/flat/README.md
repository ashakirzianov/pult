# The flat Star

The Star's mark, from `star-genart` (monore `/ashakirzianov/pult/star-genart`) at changeset `sha256:0e1cbcc803d339b2137e97652ce1939335b7928e9f8312136dc02f7c3b149a53`, where it is tuned (its `flat.html` lays out every state and setting), never edited here: `star.ts` and `star.css` are its `src/flat/` files, and `states.ts` its `src/continuous/states.ts`, byte for byte, but for two first lines: `star.ts`'s, the import of the states' type, which here is `./states.ts`, and `states.ts`'s, a comment whose name for monore is respelled here. Pult's five looks each name the state of the mark they draw (`LOOK_STATES` in `../look.ts`). To take a newer mark, copy the three files from its changeset, put both first lines back, and name that changeset here.

The repository's formatter leaves this directory alone (`fmt.ignorePatterns` in the root `vite.config.ts`), so the copy stays comparable to its source: from this repository's root, `monore -C <a star-genart checkout> show <changeset> src/flat/star.ts | diff - apps/pult/src/stars/flat/star.ts` shows the import line alone.

The square draws the mark live (`src/panel/StarCard.tsx`), the tab a still of it (`src/stars/mark.ts`).
