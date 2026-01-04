import type { PluginDefinition } from '../types/saw'

export const plugins: PluginDefinition[] = [
  {
    id: 'audio_lowpass',
    name: 'Audio Lowpass',
    version: '0.1.0',
    description: 'Upload an MP3, apply a lowpass filter, and preview the waveform (real WebAudio).',
    inputs: [],
    outputs: [{ id: 'audio', name: 'audio', type: 'Audio' }],
    parameters: [
      { id: 'cutoff_hz', label: 'Cutoff (Hz)', kind: 'number', default: 1200, min: 40, max: 20000 },
    ],
  },
  {
    id: 'load_csv',
    name: 'Load CSV',
    version: '1.0.0',
    description: 'Load a CSV file into a DataFrame (mocked).',
    inputs: [],
    outputs: [{ id: 'df', name: 'dataframe', type: 'DataFrame' }],
    parameters: [
      { id: 'path', label: 'Path', kind: 'text', default: 'data/experiment.csv' },
      { id: 'delimiter', label: 'Delimiter', kind: 'select', default: ',', options: [',', ';', '\t'] },
    ],
  },
  {
    id: 'filter_rows',
    name: 'Filter Rows',
    version: '1.2.0',
    description: 'Filter rows by a boolean expression (mocked).',
    inputs: [{ id: 'df_in', name: 'input', type: 'DataFrame' }],
    outputs: [{ id: 'df_out', name: 'filtered', type: 'DataFrame' }],
    parameters: [{ id: 'expr', label: 'Expression', kind: 'text', default: 'col("signal") > 0.5' }],
  },
  {
    id: 'normalize',
    name: 'Normalize',
    version: '0.9.1',
    description: 'Normalize numeric columns using z-score (mocked).',
    inputs: [{ id: 'df', name: 'input', type: 'DataFrame' }],
    outputs: [{ id: 'df_norm', name: 'normalized', type: 'DataFrame' }],
    parameters: [
      { id: 'method', label: 'Method', kind: 'select', default: 'zscore', options: ['zscore', 'minmax'] },
      { id: 'eps', label: 'Epsilon', kind: 'number', default: 1e-6, min: 0, max: 1 },
    ],
  },
  {
    id: 'pca',
    name: 'PCA',
    version: '2.0.0',
    description: 'Dimensionality reduction (mocked).',
    inputs: [{ id: 'df', name: 'input', type: 'DataFrame' }],
    outputs: [{ id: 'emb', name: 'embedding', type: 'Embedding' }],
    parameters: [{ id: 'n_components', label: 'Components', kind: 'number', default: 2, min: 2, max: 64 }],
  },
  {
    id: 'train_classifier',
    name: 'Train Classifier',
    version: '0.3.0',
    description: 'Train a simple classifier on embeddings (mocked).',
    inputs: [
      { id: 'x', name: 'features', type: 'Embedding' },
      { id: 'y', name: 'labels', type: 'Labels' },
    ],
    outputs: [{ id: 'model', name: 'model', type: 'Model' }],
    parameters: [
      { id: 'algo', label: 'Algorithm', kind: 'select', default: 'logreg', options: ['logreg', 'svm', 'rf'] },
      { id: 'seed', label: 'Seed', kind: 'number', default: 42, min: 0, max: 9999 },
    ],
  },
  {
    id: 'predict',
    name: 'Predict',
    version: '0.3.0',
    description: 'Run inference with a trained model (mocked).',
    inputs: [
      { id: 'model', name: 'model', type: 'Model' },
      { id: 'x', name: 'features', type: 'Embedding' },
    ],
    outputs: [{ id: 'pred', name: 'predictions', type: 'Predictions' }],
    parameters: [{ id: 'threshold', label: 'Threshold', kind: 'number', default: 0.5, min: 0, max: 1 }],
  },
  {
    id: 'plot_scatter',
    name: 'Plot Scatter',
    version: '1.1.0',
    description: 'Scatter plot (mocked UI-only).',
    inputs: [{ id: 'emb', name: 'points', type: 'Embedding' }],
    outputs: [{ id: 'viz', name: 'viz', type: 'Visualization' }],
    parameters: [
      { id: 'x', label: 'X axis', kind: 'text', default: 'pc1' },
      { id: 'y', label: 'Y axis', kind: 'text', default: 'pc2' },
      { id: 'color', label: 'Color by', kind: 'text', default: 'label' },
    ],
  },
  {
    id: 'labels_from_column',
    name: 'Labels From Column',
    version: '0.1.0',
    description: 'Extract labels from a DataFrame column (mocked).',
    inputs: [{ id: 'df', name: 'input', type: 'DataFrame' }],
    outputs: [{ id: 'y', name: 'labels', type: 'Labels' }],
    parameters: [{ id: 'column', label: 'Column', kind: 'text', default: 'condition' }],
  },
]

export function getPlugin(pluginId: string) {
  const p = plugins.find((x) => x.id === pluginId)
  if (!p) throw new Error(`Unknown plugin: ${pluginId}`)
  return p
}


