local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")
local TraceFeedback = {}

local FeedbackModal = nil :: ScreenGui?
local FeedbackTemplate = script.Parent:WaitForChild("FeedbackPrompt") :: ScreenGui
local SubmitFeedback = script.Parent:WaitForChild("SubmitFeedback") :: RemoteEvent

local hasSubmitted = false
local MINIMUM_WORDS = 3
local MAXIMUM_CHARACTERS = 221
local FADE_INFO = TweenInfo.new(0.18, Enum.EasingStyle.Quart, Enum.EasingDirection.Out)
local DISABLED_BACKGROUND_TRANSPARENCY = 0.35
local DISABLED_TEXT_TRANSPARENCY = 0.3

local function hasEnoughWords(text: string): boolean
	local count = 0
	for _ in string.gmatch(text, "%S+") do
		count += 1
		if count >= MINIMUM_WORDS then return true end
	end
	return false
end

local function truncateToCharacterLimit(text: string): string
	local characterCount = utf8.len(text)
	if not characterCount then return string.sub(text, 1, MAXIMUM_CHARACTERS) end
	if characterCount <= MAXIMUM_CHARACTERS then return text end

	local nextCharacter = utf8.offset(text, MAXIMUM_CHARACTERS + 1)
	return if nextCharacter then string.sub(text, 1, nextCharacter - 1) else text
end

local function closeModal()
	local modal = FeedbackModal
	FeedbackModal = nil
	if modal then modal:Destroy() end
end

local function initializeModal(UI: ScreenGui)
	local holder = UI:WaitForChild("Holder") :: Frame
	local limit = UI:WaitForChild("Limit") :: Frame
	local inputBox = holder:WaitForChild("InputBox") :: TextBox
	local submitButton = holder:WaitForChild("SubmitButton") :: TextButton
	local submitText = submitButton:WaitForChild("SubmitText") :: TextLabel
	local darken = holder:WaitForChild("Darken") :: Frame
	local darkenGradient = darken:WaitForChild("UIGradient") :: UIGradient

	holder.Visible = not hasSubmitted
	limit.Visible = hasSubmitted
	inputBox.MultiLine = true
	inputBox.ClearTextOnFocus = false
	inputBox.TextEditable = true
	inputBox.MaxVisibleGraphemes = MAXIMUM_CHARACTERS

	local canSubmit = false
	local introComplete = false
	local function updateSubmitState()
		local limitedText = truncateToCharacterLimit(inputBox.Text)
		if limitedText ~= inputBox.Text then inputBox.Text = limitedText end
		canSubmit = introComplete and hasEnoughWords(inputBox.Text)
		submitButton.Active = canSubmit
		submitButton.Interactable = canSubmit
		TweenService:Create(submitButton, FADE_INFO, {
			BackgroundTransparency = if canSubmit then 0 else DISABLED_BACKGROUND_TRANSPARENCY,
		}):Play()
		TweenService:Create(submitText, FADE_INFO, {
			TextTransparency = if canSubmit then 0 else DISABLED_TEXT_TRANSPARENCY,
		}):Play()
	end

	inputBox:GetPropertyChangedSignal("Text"):Connect(updateSubmitState)
	updateSubmitState()
	darkenGradient.Transparency = NumberSequence.new({
		NumberSequenceKeypoint.new(0, 1),
		NumberSequenceKeypoint.new(0.45, 1),
		NumberSequenceKeypoint.new(0.55, 0),
		NumberSequenceKeypoint.new(1, 0),
	})
	darkenGradient.Offset = Vector2.new(-1, 0)
	local revealTween = TweenService:Create(
		darkenGradient,
		TweenInfo.new(3, Enum.EasingStyle.Linear, Enum.EasingDirection.Out),
		{ Offset = Vector2.new(1, 0) }
	)
	revealTween.Completed:Connect(function()
		introComplete = true
		darken.Visible = false
		updateSubmitState()
	end)
	revealTween:Play()

	local function submit()
		if hasSubmitted or not canSubmit then return end
		hasSubmitted = true
		SubmitFeedback:FireServer(inputBox.Text)
		closeModal()
	end

	local holderCloseButton = holder:WaitForChild("CloseButton") :: TextButton
	local limitCloseButton = limit:WaitForChild("CloseButton") :: TextButton
	local limitButton = limit:WaitForChild("SubmitButton") :: TextButton
	submitButton.Activated:Connect(submit)
	holderCloseButton.Activated:Connect(closeModal)
	limitCloseButton.Activated:Connect(closeModal)
	limitButton.Activated:Connect(closeModal)
end

local function createFeedbackModal(): (boolean, ScreenGui?, string?)
	local player = Players.LocalPlayer
	if not player then return false, nil, "LocalPlayer is unavailable" end
	local playerGui = player:FindFirstChildOfClass("PlayerGui") or player:WaitForChild("PlayerGui", 5)
	if not playerGui then return false, nil, "PlayerGui is unavailable" end

	local UI = FeedbackTemplate:Clone()
	UI.ResetOnSpawn = false
	UI.Parent = playerGui
	initializeModal(UI)
	return true, UI, nil
end

function TraceFeedback:Prompt()
	if RunService:IsServer() then return end

	if FeedbackModal ~= nil then return end

	local success, UI, _error = createFeedbackModal()
	if not success then return end

	FeedbackModal = UI
end

return TraceFeedback
