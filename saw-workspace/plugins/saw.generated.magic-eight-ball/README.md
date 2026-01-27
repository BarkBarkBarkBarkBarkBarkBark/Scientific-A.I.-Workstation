# Magic Eight Ball (SAW Plugin)

Ask a question and get one of 8 canned “Magic Eight Ball” style answers.

## Params
- `question` (string): the question you want answered
- `seed` (string, optional): if provided, the answer is deterministic for the same `seed + question`

## Outputs
- `answer` (string)
- `details` (object): includes the chosen index and the full answer list
