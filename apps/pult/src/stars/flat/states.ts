// The Star's states, as Pult reads them (xaxis `pult/issues/star-states.md`), in order: every generated Star has a look for each, and Pult shows each state's still. When several hold, Pult shows the first of troubled, waiting, talking, thinking, delegating, listening, finished, awake; asleep and stirring hold only alone.
export const states = {
  asleep: "no current conversation",
  stirring: "asleep, and the user is typing to it",
  thinking: "working, no answer streaming",
  talking: "working, its answer streaming",
  finished: "a minute after it finished",
  awake: "awake, after that minute",
  listening: "awake, and the user is typing to it",
  delegating: "its subagents working, itself not",
  waiting: "an approval or a question awaits the user",
  troubled: "its last turn failed, or a limit stopped it",
} as const;

export type State = keyof typeof states;

export const stateNames = Object.keys(states) as State[];
