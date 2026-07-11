import type { WebSocketServer } from 'ws';

/**
 * TASKMASTER WEBSOCKET UTILITIES
 * ==============================
 * 
 * Utilities for broadcasting TaskMaster state changes via WebSocket.
 * Integrates with the existing WebSocket system to provide real-time updates.
 */

/**
 * Broadcast TaskMaster project update to all connected clients.
 *
 * The payload key is `projectId` post-migration so frontend listeners can
 * match notifications against the DB-assigned project identifier they
 * already use everywhere else.
 *
 * @param {WebSocket.Server} wss - WebSocket server instance
 * @param {string} projectId - DB id of the updated project
 * @param {Object} taskMasterData - Updated TaskMaster data
 */
export function broadcastTaskMasterProjectUpdate(wss: WebSocketServer, projectId: string, taskMasterData: unknown): void {
    if (!wss || !projectId) {
        console.warn('TaskMaster WebSocket broadcast: Missing wss or projectId');
        return;
    }

    const message = {
        type: 'taskmaster-project-updated',
        projectId,
        taskMasterData,
        timestamp: new Date().toISOString()
    };

    
    wss.clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(JSON.stringify(message));
            } catch (error) {
                console.error('Error sending TaskMaster project update:', error);
            }
        }
    });
}

/**
 * Broadcast TaskMaster tasks update for a specific project.
 *
 * @param {WebSocket.Server} wss - WebSocket server instance
 * @param {string} projectId - DB id of the project with updated tasks
 * @param {Object} tasksData - Updated tasks data
 */
export function broadcastTaskMasterTasksUpdate(wss: WebSocketServer, projectId: string, tasksData: unknown): void {
    if (!wss || !projectId) {
        console.warn('TaskMaster WebSocket broadcast: Missing wss or projectId');
        return;
    }

    const message = {
        type: 'taskmaster-tasks-updated',
        projectId,
        tasksData,
        timestamp: new Date().toISOString()
    };

    
    wss.clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(JSON.stringify(message));
            } catch (error) {
                console.error('Error sending TaskMaster tasks update:', error);
            }
        }
    });
}

/**
 * Broadcast MCP server status change
 * @param {WebSocket.Server} wss - WebSocket server instance
 * @param {Object} mcpStatus - Updated MCP server status
 */
export function broadcastMCPStatusChange(wss: WebSocketServer, mcpStatus: unknown): void {
    if (!wss) {
        console.warn('TaskMaster WebSocket broadcast: Missing wss');
        return;
    }

    const message = {
        type: 'taskmaster-mcp-status-changed',
        mcpStatus,
        timestamp: new Date().toISOString()
    };

    
    wss.clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(JSON.stringify(message));
            } catch (error) {
                console.error('Error sending TaskMaster MCP status update:', error);
            }
        }
    });
}

/**
 * Broadcast general TaskMaster update notification
 * @param {WebSocket.Server} wss - WebSocket server instance
 * @param {string} updateType - Type of update (e.g., 'initialization', 'configuration')
 * @param {Object} data - Additional data about the update
 */
export function broadcastTaskMasterUpdate(wss: WebSocketServer, updateType: string, data: unknown = {}): void {
    if (!wss || !updateType) {
        console.warn('TaskMaster WebSocket broadcast: Missing wss or updateType');
        return;
    }

    const message = {
        type: 'taskmaster-update',
        updateType,
        data,
        timestamp: new Date().toISOString()
    };

    
    wss.clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(JSON.stringify(message));
            } catch (error) {
                console.error('Error sending TaskMaster update:', error);
            }
        }
    });
}