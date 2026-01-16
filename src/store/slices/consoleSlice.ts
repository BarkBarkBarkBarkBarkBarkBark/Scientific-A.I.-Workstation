import type { SawState } from '../storeTypes'

export function createConsoleSlice(
  set: (partial: Partial<SawState> | ((s: SawState) => Partial<SawState>), replace?: boolean) => void,
): Pick<SawState, 'logs' | 'errors' | 'errorLog' | 'clearErrors'> {
  return {
    logs: [
      '[runtime] SAW boot: ok',
      '[runtime] execution engine: SAW API plugins',
      '[graph] drag plugins in to build a pipeline',
    ],
    errors: [
      'Traceback (most recent call last):',
      '  File "pipeline.py", line 42, in <module>',
      '    run_pipeline()',
      '  File "pipeline.py", line 19, in run_pipeline',
      '    df = load_csv(path="data/missing.csv")',
      'FileNotFoundError: [Errno 2] No such file or directory: data/missing.csv',
    ],
    errorLog: [],

    clearErrors: () => set((s) => ({ errors: [], logs: [...s.logs, '[console] errors cleared'] })),
  }
}
