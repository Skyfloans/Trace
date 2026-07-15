local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ScriptContext = game:GetService("ScriptContext")

local Batcher = require(script.Batcher)
local Config = require(script.Config)
local LogCollector = require(script.LogStack)
local TraceShared = ReplicatedStorage:WaitForChild("TraceShared")
local Protocol = require(TraceShared:WaitForChild("Protocol"))

type Session = Batcher.Session
type Level = Batcher.Level
type RateState = {
	windowStartedAt: number,
	count: number,
	dropped: number,
}

local allowedLevels = {
	trace = true,
	info = true,
	warning = true,
	error = true,
}

local remote = ReplicatedStorage:FindFirstChild(Protocol.RemoteName)
if remote and not remote:IsA("RemoteEvent") then
	error(`[Trace] ReplicatedStorage.{Protocol.RemoteName} must be a RemoteEvent`)
end
if not remote then
	remote = Instance.new("RemoteEvent")
	remote.Name = Protocol.RemoteName
	remote.Parent = ReplicatedStorage
end
local clientLogRemote = remote :: RemoteEvent

local batcher = Batcher.new(Config)
local playerSessions: { [Player]: Session } = {}
local rateStates: { [Player]: RateState } = {}
local closing = false

local function nowIso(): string return DateTime.now():ToIsoDate() end

local function createSession(player: Player): Session
	local existingSession = playerSessions[player]
	if existingSession then return existingSession end

	local timestamp = nowIso()
	local session: Session = {
		id = HttpService:GenerateGUID(false),
		playerId = tostring(player.UserId),
		playerName = player.Name,
		playerDisplayName = player.DisplayName,
		startedAt = timestamp,
		lastSeenAt = timestamp,
	}
	playerSessions[player] = session
	batcher:UpdateSession(session)
	return session
end

local function getSession(player: Player): Session return playerSessions[player] or createSession(player) end

local function endSession(player: Player, reason: string)
	local session = playerSessions[player]
	if not session then return end

	local timestamp = nowIso()
	session.lastSeenAt = timestamp
	session.endedAt = timestamp
	session.endReason = reason
	batcher:UpdateSession(session)
	playerSessions[player] = nil
	rateStates[player] = nil
end

local function consumeClientRateLimit(player: Player): (boolean, number)
	local timestamp = os.clock()
	local state = rateStates[player]
	if not state then
		state = {
			windowStartedAt = timestamp,
			count = 0,
			dropped = 0,
		}
		rateStates[player] = state
	elseif timestamp - state.windowStartedAt >= Protocol.ClientRateWindowSeconds then
		state.windowStartedAt = timestamp
		state.count = 0
	end

	if state.count >= Protocol.ClientRateLimit then
		state.dropped += 1
		return false, 0
	end

	state.count += 1
	local dropped = state.dropped
	state.dropped = 0
	return true, dropped
end

local function sanitizeString(value: any, maximumLength: number): string?
	if typeof(value) ~= "string" then return nil end
	return string.sub(value, 1, maximumLength)
end

clientLogRemote.OnServerEvent:Connect(function(player, payload)
	if closing or typeof(payload) ~= "table" then return end

	local level = payload.level
	local message = sanitizeString(payload.message, Protocol.MaxMessageLength)
	if typeof(level) ~= "string" or not allowedLevels[level] or not message or message == "" then return end
	level = level :: Level
	local repeatCount = 1
	if typeof(payload.repeatCount) == "number" and payload.repeatCount == payload.repeatCount then
		repeatCount = math.clamp(math.floor(payload.repeatCount), 1, Protocol.MaxRepeatCount)
	end

	local allowed, dropped = consumeClientRateLimit(player)
	if not allowed then return end

	local session = getSession(player)
	session.lastSeenAt = nowIso()
	batcher:UpdateSession(session)

	local context: { [string]: any } = {
		clientReported = true,
	}
	if dropped > 0 then context.droppedClientLogs = dropped end
	if typeof(payload.context) == "table" then
		local device = sanitizeString(payload.context.device, 32)
		if device then
			context.device = device
			session.device = device
			batcher:UpdateSession(session)
		end
	end

	batcher:AddEvent({
		id = HttpService:GenerateGUID(false),
		sessionId = session.id,
		occurredAt = nowIso(),
		source = "client",
		level = level,
		message = message,
		stack = sanitizeString(payload.stack, Protocol.MaxStackLength),
		sourceScript = sanitizeString(payload.sourceScript, Protocol.MaxSourceScriptLength),
		context = context,
		repeatCount = repeatCount,
	})
end)

local serverCollector = LogCollector.new(
	function(event)
		batcher:AddEvent({
			id = HttpService:GenerateGUID(false),
			occurredAt = nowIso(),
			source = "server",
			level = event.level,
			message = string.sub(event.message, 1, Protocol.MaxMessageLength),
			stack = sanitizeString(event.stack, Protocol.MaxStackLength),
			sourceScript = sanitizeString(event.sourceScript, Protocol.MaxSourceScriptLength),
		})
	end,
	{
		captureOutput = Config.CaptureOutputMessages,
	}
)

ScriptContext.Error:Connect(
	function(message, stackTrace, sourceScript) serverCollector:Error(message, stackTrace, sourceScript) end
)

LogService.MessageOut:Connect(function(message, messageType) serverCollector:Message(messageType, message) end)

Players.PlayerAdded:Connect(createSession)
Players.PlayerRemoving:Connect(function(player) endSession(player, "left") end)

for _, player in Players:GetPlayers() do
	createSession(player)
end

batcher:Start()

task.spawn(function()
	while not closing do
		task.wait(Config.HeartbeatIntervalSeconds)
		if closing then break end

		local timestamp = nowIso()
		for _, session in playerSessions do
			session.lastSeenAt = timestamp
			batcher:UpdateSession(session)
		end
	end
end)

game:BindToClose(function()
	closing = true
	for player in playerSessions do
		endSession(player, "server_shutdown")
	end
	batcher:MarkJobEnded()
	batcher:FlushAll(20)
end)
