/**
 * Agent profiles (智能体档案) CRUD + JSON import/export.
 *
 * A profile is a named launch preset. Launching one is a pure frontend action
 * (it dispatches the composer's existing preference events); the server only
 * owns storage, so these routes are plain owner-scoped CRUD over
 * `agentProfilesDb`, plus bulk import/export for portability.
 */

import express from 'express';

import { agentProfilesDb } from '@/modules/database/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const EXPORT_VERSION = 1;

function readUserId(req: express.Request): number {
  const userId = Number((req as express.Request & { user?: { id?: unknown } }).user?.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AppError('Authenticated user is missing', { code: 'UNAUTHENTICATED', statusCode: 401 });
  }
  return userId;
}

function readProfileId(req: express.Request): string {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  if (!id) {
    throw new AppError('Profile id is required', { code: 'AGENT_PROFILE_ID_REQUIRED', statusCode: 400 });
  }
  return id;
}

// List all of the user's profiles.
router.get('/', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  res.json(createApiSuccessResponse({ profiles: agentProfilesDb.listProfiles(userId) }));
}));

// Export every profile as a portable JSON document.
router.get('/export', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  const profiles = agentProfilesDb.listProfiles(userId);
  res.json(createApiSuccessResponse({
    version: EXPORT_VERSION,
    kind: 'leocodebox-agent-profiles',
    profiles,
  }));
}));

// Fetch one profile.
router.get('/:id', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  const profile = agentProfilesDb.getProfile(userId, readProfileId(req));
  if (!profile) {
    throw new AppError('Profile not found', { code: 'AGENT_PROFILE_NOT_FOUND', statusCode: 404 });
  }
  res.json(createApiSuccessResponse({ profile }));
}));

// Create a profile.
router.post('/', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  const profile = agentProfilesDb.createProfile(userId, req.body);
  res.status(201).json(createApiSuccessResponse({ profile }));
}));

// Import a batch of profiles (each gets a fresh id — never clobbers existing ones).
router.post('/import', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  const body = req.body as { profiles?: unknown } | unknown;
  const rawList = Array.isArray(body)
    ? body
    : Array.isArray((body as { profiles?: unknown })?.profiles)
      ? (body as { profiles: unknown[] }).profiles
      : null;
  if (!rawList) {
    throw new AppError('Import payload must be an array of profiles', {
      code: 'AGENT_PROFILE_IMPORT_INVALID',
      statusCode: 400,
    });
  }
  const imported = agentProfilesDb.importProfiles(userId, rawList);
  res.status(201).json(createApiSuccessResponse({ profiles: imported, count: imported.length }));
}));

// Update a profile.
router.put('/:id', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  const updated = agentProfilesDb.updateProfile(userId, readProfileId(req), req.body);
  if (!updated) {
    throw new AppError('Profile not found', { code: 'AGENT_PROFILE_NOT_FOUND', statusCode: 404 });
  }
  res.json(createApiSuccessResponse({ profile: updated }));
}));

// Delete a profile.
router.delete('/:id', asyncHandler(async (req, res) => {
  const userId = readUserId(req);
  const removed = agentProfilesDb.deleteProfile(userId, readProfileId(req));
  if (!removed) {
    throw new AppError('Profile not found', { code: 'AGENT_PROFILE_NOT_FOUND', statusCode: 404 });
  }
  res.json(createApiSuccessResponse({ removed: true }));
}));

export default router;
