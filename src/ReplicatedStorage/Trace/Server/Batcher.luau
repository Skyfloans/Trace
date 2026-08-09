local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

type Config = {
	Endpoint: string,
	IngestionSecretName: string,
	DevelopmentIngestionKey: string?,
	FlushIntervalSeconds: number,
	EventAggregationWindowSeconds: number,
	HeartbeatIntervalSeconds: number,
	MaxEventsPerBatch: number,
	MaxRepeatCount: number,
	MaxBatchUncompressedBytes: number,
	MaxSessionsPerBatch: number,
	MaxQueuedEvents: number,
	MaxSampledStackKeys: number,
}

export type Session = {
	id: string,
	playerId: string,
	playerName: string?,
	playerDisplayName: string?,
	device: string?,
	platform: string?,
	startedAt: string,
	endedAt: string?,
	lastSeenAt: string,
	endReason: string?,
}

export type Level = "trace" | "info" | "warning" | "error"

export type Event = {
	id: string,
	sessionId: string?,
	occurredAt: string,
	source: "client" | "server",
	level: Level,
	message: string,
	stack: string?,
	sourceScript: string?,
	context: { [string]: any }?,
	lastOccurredAt: string?,
	repeatCount: number?,
	_aggregationKey: string?,
	_flushAt: number?,
}

export type Feedback = {
	id: string,
	sessionId: string,
	submittedAt: string,
	message: string,
}

type Batcher = {
	_config: Config,
	_authorization: any,
	_job: { [string]: any },
	_jobVersion: number,
	_sentJobVersion: number,
	_sessions: { [string]: Session },
	_sessionVersions: { [string]: number },
	_sentSessionVersions: { [string]: number },
	_events: { Event },
	_feedback: { Feedback },
	_pendingEventsByKey: { [string]: Event },
	_pendingEventCount: number,
	_sampledStackKeys: { [string]: boolean },
	_sampledStackKeyCount: number,
	_running: boolean,
	_flushing: boolean,
	_nextAttemptAt: number,
	_retryDelay: number,
	UpdateSession: (self: Batcher, session: Session) -> (),
	AddEvent: (self: Batcher, event: Event) -> boolean,
	AddFeedback: (self: Batcher, feedback: Feedback) -> boolean,
	FinalizeSession: (self: Batcher, sessionId: string) -> (),
	MarkJobEnded: (self: Batcher) -> (),
	Start: (self: Batcher) -> (),
	Flush: (self: Batcher, force: boolean?) -> boolean,
	FlushAll: (self: Batcher, maximumBatches: number?) -> boolean,
	_buildBatch: (self: Batcher, eventLimit: number?) -> ({ [string]: any }, number, { [string]: number }, number),
	_hasPendingData: (self: Batcher) -> boolean,
	_finalizePendingEvents: (self: Batcher, force: boolean, sessionId: string?) -> (),
}

local Batcher = {}
Batcher.__index = Batcher

local function nowIso(): string return DateTime.now():ToIsoDate() end

local function getAuthorization(config: Config): any
	if config.DevelopmentIngestionKey then return "Bearer " .. config.DevelopmentIngestionKey end

	local success, secret = pcall(HttpService.GetSecret, HttpService, config.IngestionSecretName)
	if success then return secret:AddPrefix("Bearer ") end

	if RunService:IsStudio() then
		warn("[Trace] Ingestion secret is unavailable. Configure DevelopmentIngestionKey for local testing.")
	else
		warn(`[Trace] Could not load the "{config.IngestionSecretName}" experience secret.`)
	end
	return nil
end

function Batcher.new(config: Config): Batcher
	local traceJobId = HttpService:GenerateGUID(false)
	local robloxJobId = game.JobId
	if robloxJobId == "" then robloxJobId = "studio-" .. traceJobId end

	local startedAt = nowIso()
	local self = setmetatable({
		_config = config,
		_authorization = getAuthorization(config),
		_job = {
			id = traceJobId,
			robloxJobId = robloxJobId,
			placeId = tostring(game.PlaceId),
			universeId = tostring(game.GameId),
			release = tostring(game.PlaceVersion),
			startedAt = startedAt,
			lastSeenAt = startedAt,
		},
		_jobVersion = 1,
		_sentJobVersion = 0,
		_sessions = {},
		_sessionVersions = {},
		_sentSessionVersions = {},
		_events = {},
		_feedback = {},
		_pendingEventsByKey = {},
		_pendingEventCount = 0,
		_sampledStackKeys = {},
		_sampledStackKeyCount = 0,
		_running = false,
		_flushing = false,
		_nextAttemptAt = 0,
		_retryDelay = config.FlushIntervalSeconds,
	}, Batcher)

	return self :: any
end

function Batcher:AddFeedback(feedback: Feedback): boolean
	if #self._feedback >= 100 then return false end
	table.insert(self._feedback, table.clone(feedback))
	return true
end

function Batcher:UpdateSession(session: Session)
	self._sessions[session.id] = table.clone(session)
	self._sessionVersions[session.id] = (self._sessionVersions[session.id] or 0) + 1
end

function Batcher:AddEvent(event: Event): boolean
	self:_finalizePendingEvents(false)

	local aggregationKey = table.concat({
		event.sessionId or "",
		event.source,
		event.level,
		event.sourceScript or "",
		event.message,
	}, "\0")
	local pending = self._pendingEventsByKey[aggregationKey]
	if pending then
		local combinedCount = (pending.repeatCount or 1) + (event.repeatCount or 1)
		if combinedCount <= self._config.MaxRepeatCount then
			pending.repeatCount = combinedCount
			pending.lastOccurredAt = event.lastOccurredAt or event.occurredAt
			return true
		end
		self._pendingEventsByKey[aggregationKey] = nil
		self._pendingEventCount -= 1
		pending._flushAt = nil
		table.insert(self._events, pending)
	end

	if #self._events + self._pendingEventCount >= self._config.MaxQueuedEvents then return false end

	local queuedEvent = table.clone(event)
	local stackSampleKey = aggregationKey
	if queuedEvent.stack then
		if self._sampledStackKeys[stackSampleKey] then
			queuedEvent.stack = nil
		elseif self._sampledStackKeyCount >= self._config.MaxSampledStackKeys then
			queuedEvent.stack = nil
		else
			self._sampledStackKeys[stackSampleKey] = true
			self._sampledStackKeyCount += 1
		end
	end
	queuedEvent.repeatCount = event.repeatCount or 1
	queuedEvent.lastOccurredAt = event.lastOccurredAt or event.occurredAt
	queuedEvent._aggregationKey = aggregationKey
	queuedEvent._flushAt = os.clock() + self._config.EventAggregationWindowSeconds
	self._pendingEventsByKey[aggregationKey] = queuedEvent
	self._pendingEventCount += 1
	return true
end

function Batcher:_finalizePendingEvents(force: boolean, sessionId: string?)
	local timestamp = os.clock()
	for aggregationKey, event in self._pendingEventsByKey do
		local matchesSession = sessionId ~= nil and event.sessionId == sessionId
		if force or matchesSession or timestamp >= (event._flushAt or 0) then
			self._pendingEventsByKey[aggregationKey] = nil
			self._pendingEventCount -= 1
			event._flushAt = nil
			table.insert(self._events, event)
		end
	end
end

function Batcher:FinalizeSession(sessionId: string) self:_finalizePendingEvents(false, sessionId) end

function Batcher:MarkJobEnded()
	self._running = false
	local timestamp = nowIso()
	self._job.lastSeenAt = timestamp
	self._job.endedAt = timestamp
	self._jobVersion += 1
end

function Batcher:_buildBatch(eventLimit: number?): ({ [string]: any }, number, { [string]: number }, number)
	local eventCount = math.min(#self._events, eventLimit or self._config.MaxEventsPerBatch)
	local events = table.create(eventCount)
	local sessions = {}
	local selectedSessionVersions = {}
	local feedback = table.clone(self._feedback)

	for index = 1, eventCount do
		local event = self._events[index]
		events[index] = table.clone(event)
		events[index]._aggregationKey = nil
		events[index]._flushAt = nil

		local sessionId = event.sessionId
		if sessionId and not selectedSessionVersions[sessionId] then
			local session = self._sessions[sessionId]
			if session then
				table.insert(sessions, session)
				selectedSessionVersions[sessionId] = self._sessionVersions[sessionId]
			end
		end
	end
	for _, item in feedback do
		if not selectedSessionVersions[item.sessionId] then
			local session = self._sessions[item.sessionId]
			if session then
				table.insert(sessions, session)
				selectedSessionVersions[item.sessionId] = self._sessionVersions[item.sessionId]
			end
		end
	end

	for sessionId, version in self._sessionVersions do
		if #sessions >= self._config.MaxSessionsPerBatch then break end
		if self._sentSessionVersions[sessionId] ~= version and not selectedSessionVersions[sessionId] then
			table.insert(sessions, self._sessions[sessionId])
			selectedSessionVersions[sessionId] = version
		end
	end

	local jobVersion = self._jobVersion
	local batch = {
		version = 1,
		batchId = HttpService:GenerateGUID(false),
		job = table.clone(self._job),
		sessions = sessions,
		events = events,
		feedback = feedback,
	}

	return batch, eventCount, selectedSessionVersions, jobVersion
end

function Batcher:_hasPendingData(): boolean
	if #self._events > 0 or #self._feedback > 0 or self._sentJobVersion ~= self._jobVersion then return true end

	for sessionId, version in self._sessionVersions do
		if self._sentSessionVersions[sessionId] ~= version then return true end
	end

	return false
end

function Batcher:Flush(force: boolean?): boolean
	self:_finalizePendingEvents(force == true)
	if self._flushing or not self:_hasPendingData() then return true end
	if not self._authorization then return false end
	if not force and os.clock() < self._nextAttemptAt then return false end

	self._flushing = true

	local eventLimit = self._config.MaxEventsPerBatch
	local batch, eventCount, sessionVersions, jobVersion = self:_buildBatch(eventLimit)
	local encodeSuccess, encodedBody = pcall(HttpService.JSONEncode, HttpService, batch)
	if not encodeSuccess then
		self._flushing = false
		warn("[Trace] Failed to encode telemetry batch.")
		return false
	end
	while #encodedBody > self._config.MaxBatchUncompressedBytes and eventCount > 1 do
		eventLimit = math.max(1, math.floor(eventCount / 2))
		batch, eventCount, sessionVersions, jobVersion = self:_buildBatch(eventLimit)
		encodeSuccess, encodedBody = pcall(HttpService.JSONEncode, HttpService, batch)
		if not encodeSuccess then
			self._flushing = false
			warn("[Trace] Failed to encode telemetry batch.")
			return false
		end
	end

	local requestSuccess, response = pcall(HttpService.RequestAsync, HttpService, {
		Url = self._config.Endpoint .. "/v1/batches",
		Method = "POST",
		Headers = {
			["Authorization"] = self._authorization,
			["Content-Type"] = "application/json",
		},
		Body = encodedBody,
		Compress = Enum.HttpCompression.Gzip,
	})

	local success = requestSuccess and response.Success
	if success then
		for _ = 1, eventCount do
			table.remove(self._events, 1)
		end
		for _ = 1, #batch.feedback do
			table.remove(self._feedback, 1)
		end
		for sessionId, version in sessionVersions do
			if self._sessionVersions[sessionId] == version then self._sentSessionVersions[sessionId] = version end
		end
		if self._jobVersion == jobVersion then self._sentJobVersion = jobVersion end
		self._retryDelay = self._config.FlushIntervalSeconds
		self._nextAttemptAt = 0
	else
		self._retryDelay = math.min(self._retryDelay * 2, 60)
		self._nextAttemptAt = os.clock() + self._retryDelay
		local status = if requestSuccess then tostring(response.StatusCode) else "network error"
		local detail = if requestSuccess then tostring(response.Body or "") else tostring(response)
		if #detail > 500 then detail = string.sub(detail, 1, 500) .. "..." end
		if detail ~= "" then
			warn(`[Trace] Telemetry upload failed ({status}): {detail}; retrying later.`)
		else
			warn(`[Trace] Telemetry upload failed ({status}); retrying later.`)
		end
	end

	self._flushing = false
	return success
end

function Batcher:FlushAll(maximumBatches: number?): boolean
	local waitDeadline = os.clock() + 5
	while self._flushing and os.clock() < waitDeadline do
		task.wait(0.1)
	end
	if self._flushing then return false end
	self:_finalizePendingEvents(true)

	local remainingBatches = maximumBatches or 20
	while self:_hasPendingData() and remainingBatches > 0 do
		if not self:Flush(true) then return false end
		remainingBatches -= 1
	end

	return not self:_hasPendingData()
end

function Batcher:Start()
	if self._running then return end
	self._running = true

	task.spawn(function()
		local nextHeartbeat = os.clock() + self._config.HeartbeatIntervalSeconds
		while self._running do
			task.wait(self._config.FlushIntervalSeconds)

			if os.clock() >= nextHeartbeat then
				self._job.lastSeenAt = nowIso()
				self._jobVersion += 1
				nextHeartbeat = os.clock() + self._config.HeartbeatIntervalSeconds
			end

			self:Flush()
		end
	end)
end

return Batcher
