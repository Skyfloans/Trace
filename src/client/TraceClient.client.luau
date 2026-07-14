local LogService = game:GetService("LogService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ScriptContext = game:GetService("ScriptContext")
local UserInputService = game:GetService("UserInputService")

local TraceShared = ReplicatedStorage:WaitForChild("TraceShared")
local LogCollector = require(TraceShared:WaitForChild("LogCollector"))
local Protocol = require(TraceShared:WaitForChild("Protocol"))
local remote = ReplicatedStorage:WaitForChild(Protocol.RemoteName)

local function truncate(value: string?, maximumLength: number): string?
	if not value then return nil end
	return string.sub(value, 1, maximumLength)
end

local function getDeviceType(): string
	if UserInputService.TouchEnabled and not UserInputService.KeyboardEnabled then return "mobile" end
	if UserInputService.GamepadEnabled and not UserInputService.KeyboardEnabled then return "console" end
	return "desktop"
end

local collector = LogCollector.new(
	function(event)
		pcall(remote.FireServer, remote, {
			level = event.level,
			message = truncate(event.message, Protocol.MaxMessageLength),
			stack = truncate(event.stack, Protocol.MaxStackLength),
			sourceScript = truncate(event.sourceScript, Protocol.MaxSourceScriptLength),
			context = {
				device = getDeviceType(),
			},
		})
	end
)

ScriptContext.Error:Connect(
	function(message, stackTrace, sourceScript) collector:Error(message, stackTrace, sourceScript) end
)

LogService.MessageOut:Connect(function(message, messageType) collector:Message(messageType, message) end)
