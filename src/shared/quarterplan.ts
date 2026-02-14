/**
 * QuarterPlan Context Sync
 * Manages quarter planning initiatives and ARR data in S3
 */

import { SharedS3Client } from './s3-client.js';

export interface Initiative {
  id: string;
  title: string;
  description: string;
  owner: string;
  status: 'planning' | 'in-progress' | 'completed' | 'blocked';
  prs: string[];
  created: string;
  updated: string;
  target_date?: string;
  tags?: string[];
}

export interface QuarterPlanData {
  version: string;
  quarter: string;
  initiatives: Initiative[];
  created: string;
  lastUpdated: string;
}

export interface ARRData {
  mrr: number;
  arr: number;
  users: number;
  updated: string;
}

export class QuarterPlanSync {
  constructor(private s3: SharedS3Client) {}

  async getQuarterPlan(): Promise<QuarterPlanData> {
    try {
      const data = await this.s3.read('quarterplan/initiatives.json');
      return JSON.parse(data);
    } catch {
      return {
        version: '1.0',
        quarter: 'Q1 2026',
        initiatives: [],
        created: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      };
    }
  }

  async saveQuarterPlan(data: QuarterPlanData): Promise<void> {
    const toSave = { ...data, lastUpdated: new Date().toISOString() };
    await this.s3.write('quarterplan/initiatives.json', JSON.stringify(toSave, null, 2));
  }

  async getARRData(): Promise<ARRData> {
    try {
      const data = await this.s3.read('quarterplan/arr-data.json');
      return JSON.parse(data);
    } catch {
      return { mrr: 0, arr: 0, users: 0, updated: new Date().toISOString() };
    }
  }

  async saveARRData(data: ARRData): Promise<void> {
    const toSave = { ...data, updated: new Date().toISOString() };
    await this.s3.write('quarterplan/arr-data.json', JSON.stringify(toSave, null, 2));
  }

  async addUpdate(initiativeId: string, update: string, author: string): Promise<void> {
    const updateData = {
      initiative_id: initiativeId,
      update,
      author,
      timestamp: new Date().toISOString(),
    };
    const filename = `quarterplan/updates/${initiativeId}-${Date.now()}.json`;
    await this.s3.write(filename, JSON.stringify(updateData, null, 2));
  }
}
