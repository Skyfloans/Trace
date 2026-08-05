--!strict

local Theme = require(script.Parent.Theme)

type Palette = Theme.Palette

local ConfirmationModal = {}

local FONT = Enum.Font.Gotham
local FONT_MEDIUM = Enum.Font.GothamMedium

local function addCorner(parent: Instance, radius: number)
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, radius)
	corner.Parent = parent
end

local function addStroke(parent: Instance, color: Color3)
	local stroke = Instance.new("UIStroke")
	stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	stroke.Color = color
	stroke.Thickness = 1
	stroke.Parent = parent
end

local function button(parent: Instance, palette: Palette, text: string, primary: boolean, xOffset: number): TextButton
	local control = Instance.new("TextButton")
	control.AutoButtonColor = false
	control.BackgroundColor3 = if primary then palette.accent else palette.button
	control.Font = FONT_MEDIUM
	control.Position = UDim2.new(1, xOffset, 1, -50)
	control.Size = UDim2.fromOffset(if primary then 132 else 88, 36)
	control.Text = text
	control.TextColor3 = if primary then palette.accentInk else palette.text
	control.TextSize = 12
	control.ZIndex = 103
	addCorner(control, 7)
	if not primary then addStroke(control, palette.border) end
	control.MouseEnter:Connect(
		function() control.BackgroundColor3 = if primary then palette.accentHover else palette.buttonHover end
	)
	control.MouseLeave:Connect(
		function() control.BackgroundColor3 = if primary then palette.accent else palette.button end
	)
	control.Parent = parent
	return control
end

function ConfirmationModal.show(
	parent: Instance,
	palette: Palette,
	titleText: string,
	bodyText: string,
	confirmText: string,
	onConfirm: () -> ()
)
	local previous = parent:FindFirstChild("TraceConfirmationModal")
	if previous then previous:Destroy() end

	local overlay = Instance.new("TextButton")
	overlay.Name = "TraceConfirmationModal"
	overlay.Active = true
	overlay.AutoButtonColor = false
	overlay.BackgroundColor3 = Color3.new(0, 0, 0)
	overlay.BackgroundTransparency = 0.32
	overlay.BorderSizePixel = 0
	overlay.Size = UDim2.fromScale(1, 1)
	overlay.Text = ""
	overlay.ZIndex = 100
	overlay.Parent = parent

	local panel = Instance.new("Frame")
	panel.AnchorPoint = Vector2.new(0.5, 0.5)
	panel.BackgroundColor3 = palette.raised
	panel.Position = UDim2.fromScale(0.5, 0.5)
	panel.Size = UDim2.new(1, -32, 0, 204)
	panel.ZIndex = 101
	addCorner(panel, 10)
	addStroke(panel, palette.border)
	panel.Parent = overlay
	local sizeConstraint = Instance.new("UISizeConstraint")
	sizeConstraint.MaxSize = Vector2.new(460, 204)
	sizeConstraint.MinSize = Vector2.new(308, 204)
	sizeConstraint.Parent = panel

	local title = Instance.new("TextLabel")
	title.BackgroundTransparency = 1
	title.Font = FONT_MEDIUM
	title.Position = UDim2.fromOffset(18, 16)
	title.Size = UDim2.new(1, -36, 0, 26)
	title.Text = titleText
	title.TextColor3 = palette.title
	title.TextSize = 16
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.ZIndex = 102
	title.Parent = panel

	local body = Instance.new("TextLabel")
	body.BackgroundTransparency = 1
	body.Font = FONT
	body.Position = UDim2.fromOffset(18, 50)
	body.Size = UDim2.new(1, -36, 0, 76)
	body.Text = bodyText
	body.TextColor3 = palette.muted
	body.TextSize = 11
	body.TextWrapped = true
	body.TextXAlignment = Enum.TextXAlignment.Left
	body.TextYAlignment = Enum.TextYAlignment.Top
	body.ZIndex = 102
	body.Parent = panel

	local cancel = button(panel, palette, "Cancel", false, -238)
	local confirm = button(panel, palette, confirmText, true, -142)
	cancel.MouseButton1Click:Connect(function() overlay:Destroy() end)
	confirm.MouseButton1Click:Connect(function()
		overlay:Destroy()
		onConfirm()
	end)
end

return ConfirmationModal
