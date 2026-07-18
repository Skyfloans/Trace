export type Level = "trace" | "info" | "warning" | "error"

export type LogEvent = {
	level: Level,
	message: string,
	stack: string?,
	sourceScript: string?,
}

type DiagnosticLevel = "warning" | "error"

type DiagnosticEntry = {
	level: DiagnosticLevel,
	message: string,
	stack: { string },
	collectingStack: boolean,
	completed: boolean,
}

type ScriptErrorEntry = {
	message: string,
	completed: boolean,
}

type CollectorOptions = {
	captureOutput: boolean?,
}

type Collector = {
	_pendingDiagnostics: { DiagnosticEntry },
	_activeDiagnostic: DiagnosticEntry?,
	_recentScriptErrors: { ScriptErrorEntry },
	_emit: (LogEvent) -> (),
	_captureOutput: boolean,
	Error: (self: Collector, message: string, stackTrace: string, sourceScript: LuaSourceContainer?) -> (),
	Message: (self: Collector, messageType: Enum.MessageType, message: string) -> (),
	_finishDiagnostic: (self: Collector, entry: DiagnosticEntry) -> (),
}

local INTERNAL_PREFIX = "[Trace]"
local DIAGNOSTIC_STACK_WAIT_SECONDS = 0.5
local ERROR_DEDUPLICATION_SECONDS = 0.5

local LogCollector = {}
LogCollector.__index = LogCollector

local function getSourceName(sourceScript: LuaSourceContainer?): string?
	if not sourceScript then return nil end

	local success, fullName = pcall(sourceScript.GetFullName, sourceScript)
	if success then return fullName end

	return sourceScript.Name
end

local function withoutSourceLocation(message: string): string
	local _, locationEnd = string.find(message, "^.-:%d+:%s+")
	if locationEnd then return string.sub(message, locationEnd + 1) end
	return message
end

local function errorMessagesMatch(first: string, second: string): boolean
	return first == second or withoutSourceLocation(first) == withoutSourceLocation(second)
end

function LogCollector.new(emit: (LogEvent) -> (), options: CollectorOptions?): Collector
	local self = setmetatable({
		_pendingDiagnostics = {},
		_activeDiagnostic = nil,
		_recentScriptErrors = {},
		_emit = emit,
		_captureOutput = options and options.captureOutput == true or false,
	}, LogCollector)

	return self :: any
end

function LogCollector:Error(message: string, stackTrace: string, sourceScript: LuaSourceContainer?)
	if string.sub(message, 1, #INTERNAL_PREFIX) == INTERNAL_PREFIX then return end

	local matchedDiagnostic: DiagnosticEntry? = nil
	local activeDiagnostic = self._activeDiagnostic
	if
		activeDiagnostic
		and activeDiagnostic.level == "error"
		and errorMessagesMatch(activeDiagnostic.message, message)
	then
		matchedDiagnostic = activeDiagnostic
		self._activeDiagnostic = nil
	else
		for index, entry in self._pendingDiagnostics do
			if entry.level == "error" and errorMessagesMatch(entry.message, message) then
				matchedDiagnostic = entry
				table.remove(self._pendingDiagnostics, index)
				break
			end
		end
	end

	if matchedDiagnostic then
		matchedDiagnostic.completed = true
	else
		local scriptError: ScriptErrorEntry = {
			message = message,
			completed = false,
		}
		table.insert(self._recentScriptErrors, scriptError)
		task.delay(ERROR_DEDUPLICATION_SECONDS, function()
			if scriptError.completed then return end
			scriptError.completed = true
			local index = table.find(self._recentScriptErrors, scriptError)
			if index then table.remove(self._recentScriptErrors, index) end
		end)
	end

	self._emit({
		level = "error",
		message = message,
		stack = stackTrace,
		sourceScript = getSourceName(sourceScript),
	})
end

function LogCollector:_finishDiagnostic(entry: DiagnosticEntry)
	if entry.completed then return end

	entry.completed = true
	local pendingIndex = table.find(self._pendingDiagnostics, entry)
	if pendingIndex then table.remove(self._pendingDiagnostics, pendingIndex) end
	if self._activeDiagnostic == entry then self._activeDiagnostic = nil end
	self._emit({
		level = entry.level,
		message = entry.message,
		stack = if #entry.stack > 0 then table.concat(entry.stack, "\n") else nil,
	})
end

function LogCollector:Message(messageType: Enum.MessageType, message: string)
	if string.sub(message, 1, #INTERNAL_PREFIX) == INTERNAL_PREFIX then return end

	if messageType == Enum.MessageType.MessageError then
		-- Luau failures normally arrive through both services. Prefer the
		-- ScriptContext event because it includes a reliable source and stack,
		-- but keep MessageOut as a fallback for engine/service-only errors.
		for index, scriptError in self._recentScriptErrors do
			if errorMessagesMatch(scriptError.message, message) then
				scriptError.completed = true
				table.remove(self._recentScriptErrors, index)
				return
			end
		end

		local entry: DiagnosticEntry = {
			level = "error",
			message = message,
			stack = {},
			collectingStack = false,
			completed = false,
		}
		table.insert(self._pendingDiagnostics, entry)

		task.delay(DIAGNOSTIC_STACK_WAIT_SECONDS, function() self:_finishDiagnostic(entry) end)
		return
	end

	if messageType == Enum.MessageType.MessageWarning then
		local entry: DiagnosticEntry = {
			level = "warning",
			message = message,
			stack = {},
			collectingStack = false,
			completed = false,
		}
		table.insert(self._pendingDiagnostics, entry)

		task.delay(DIAGNOSTIC_STACK_WAIT_SECONDS, function() self:_finishDiagnostic(entry) end)
		return
	end

	if message == "Stack Begin" then
		local entry = table.remove(self._pendingDiagnostics, 1)
		if entry then
			entry.collectingStack = true
			self._activeDiagnostic = entry
		end
		return
	end

	if message == "Stack End" then
		local entry = self._activeDiagnostic
		self._activeDiagnostic = nil
		if entry then self:_finishDiagnostic(entry) end
		return
	end

	local activeDiagnostic = self._activeDiagnostic
	if activeDiagnostic then
		table.insert(activeDiagnostic.stack, message)
		return
	end

	if self._captureOutput then self._emit({
		level = "info",
		message = message,
	}) end
end

return LogCollector
