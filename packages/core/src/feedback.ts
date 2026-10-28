import { z } from 'zod';
import { ID } from './domain.js';

export const workFeedbackSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    artifactId: ID.nullable(),
    decision: z.enum(['comment', 'accept', 'reject', 'changes_requested']),
    dimensions: z.array(z.enum(['creative', 'content', 'execution', 'technical'])).max(4),
    content: z.string().trim().min(1).max(20000),
  })
  .strict();
export type WorkFeedbackInput = z.infer<typeof workFeedbackSchema>;
export type FeedbackOrigin = { kind: 'direct' } | { kind: 'conversation'; messageId: string };
export type WorkFeedback = {
  id: string;
  requestId: string;
  taskVersion: number;
  artifact: { id: string; stage: string; revision: number; hash: string } | null;
  decision: WorkFeedbackInput['decision'];
  dimensions: WorkFeedbackInput['dimensions'];
  content: string;
  origin: FeedbackOrigin;
};
export const feedbackLabels: Record<WorkFeedbackInput['decision'] | 'unreviewed', string> = {
  comment: '已记录意见',
  accept: '用户已接受',
  reject: '用户已拒绝',
  changes_requested: '用户要求修改',
  unreviewed: '尚无用户采用结论',
};
