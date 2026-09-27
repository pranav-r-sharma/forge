import * as path from 'path';
import { expandTilde, MlxLocalModel } from './mlxModels';

export type MlxModelPickAction = 'model' | 'addFolder' | 'changeLibrary';

export interface MlxModelQuickPickItem {
  label: string;
  description?: string;
  action: MlxModelPickAction;
  modelId?: string;
}

export function formatMlxModelSize(bytes: number): string {
  if (!bytes) return '';
  const gb = bytes / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/** True when the configured forge.mlx.model matches this entry (repo id or legacy absolute snapshot path). */
export function mlxModelMatchesSetting(model: MlxLocalModel, currentSetting: string): boolean {
  const c = (currentSetting || '').trim();
  if (!c) return false;
  if (c === model.id) return true;
  try {
    const resolved = path.resolve(expandTilde(c));
    return resolved === model.dir;
  } catch {
    return false;
  }
}

/** Pure QuickPick rows for the MLX chat-model picker (models + folder/library actions). */
export function buildMlxModelQuickPickItems(models: MlxLocalModel[], currentSetting: string): MlxModelQuickPickItem[] {
  const rows: MlxModelQuickPickItem[] = models.map((m) => {
    const current = mlxModelMatchesSetting(m, currentSetting);
    const size = formatMlxModelSize(m.sizeBytes);
    return {
      label: m.id,
      description: current ? `${size} (current)` : size,
      action: 'model',
      modelId: m.id,
    };
  });
  rows.push({ label: '$(folder) Add a model folder…', action: 'addFolder' });
  rows.push({ label: '$(gear) Change model library folder…', action: 'changeLibrary' });
  return rows;
}
