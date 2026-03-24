# Make soft link from ~/.config/opencode/opencode.json to ./opencode.json
mkdir -p ~/.config/opencode
ln -s $(pwd)/opencode.json ~/.config/opencode/opencode.json

