# My Shell Setup Script

Including bash / zsh basic setup and some common functions.

## Usage

Basic setup for bash:

```bash
git clone https://github.com/graycarl/dotshell.git ~/.shell
ln -s ~/.shell/bashrc.sh ~/.bashrc
```

Basic setup for zsh (using oh-my-zsh):

```bash
git clone https://github.com/graycarl/dotshell.git ~/.shell
git submodules update --init oh-my-zsh
ln -s ~/.shell/zshrc.sh ~/.zshrc
chsh -s /bin/zsh
```

## Apps

```bash
$ ln -s ~/.shell/apps/cheat/sheets ~/.cheat
```
