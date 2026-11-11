# The flat Star

The Star's mark, from `../pult-star` at commit `06604e0`, where it is tuned (its `flat.html` lays out every state and setting), never edited here: `star.ts` and `star.css` are its `src/flat/` files, and `states.ts` its `src/continuous/states.ts`, byte for byte, but for `star.ts`'s first line, the import of the states' type, which here is `look.ts`'s `StarLook`. `look.ts` checks that the looks are `states.ts`'s states, name for name. To take a newer mark, copy the three files from that commit again, put the import line back, and name the commit here.

The repository's formatter leaves this directory alone (`fmt.ignorePatterns` in the root `vite.config.ts`), so the copy stays comparable to its source: `git -C ../pult-star show <commit>:src/flat/star.ts | diff - apps/pult/src/stars/flat/star.ts` shows the import line alone.

The card draws the mark live (`src/panel/StarCard.tsx`), the tab a still of it (`src/stars/mark.ts`).
