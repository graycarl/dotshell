# Init dev env on SteamOS

Because of steamos is a readonly OS, we need to initialize dev env without `sudo steamos-readonly disable`.

1. Switch to desktop mode;
2. Start konsole app;
3. Set password for `deck` user: `passwd`;
4. Setup shell;
   ```bash
   $ git clone https://github.com/graycarl/dotshell.git ~/.shell
   $ cd .shell
   $ git submodule update --init
   $ ln -s ~/.shell/zshrc ~/.zshrc
   $ cd oh-my-zsh/custom/themes
   $ ln -s ~/.shell/zsh-custom/themes/* .
   $ chsh -s /bin/zsh
   # then restart steamos
   ```
5. Setup homebrew;
   ```bash
   $ # install homebrew by following offical guide
   $ # add initial script to ~/.shell/local/shrc
   $ # like this: eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
   $ brew install glibc
   $ brew install gcc
   $ brew install make
   $ ln -s $(brew --prefix)/bin/gcc-14 $(brew --prefix)/bin/gcc
   ```
6. Setup pyenv;
   ```bash 
   $ brew install pyenv
   $ brew install pyenv-virtualenv
   $ pyenv install 3.12
   $ pyenv global 3.12
   ```
7. Setup tmux-init;
8. Setup neovim;
   ```bash
   $ git clone https://github.com/graycarl/dotvim.git ~/.vim
   $ ln -s ~/.vim ~/.config/nvim
   $ brew install neovim
   $ # add alias vim -> nvim in .shell/local/shrc
   $ brew install node
   $ nvim  # and wait for initial finished
   ```
9. Setup input method:
   - Install fcitx5 using Software store;
   - Install Chinese addon from software store;
   - Config it.
   - 现在就可以在输入法中切换中英文了。
10. Setup pacman;
  ```bash
  $ sudo pacman --init
  $ sudo pacman-key --populate archlinux
  $ sudo pacman-key --populate holo
  ```
11. Setup clipboard for tmux and neovim
  ```bash
  $ brew install xsel
  # use `+` register in neovim, because `*` register is for primary clipboard
  ```
12. Setup clipboard hotkey for konsole
  - Open konsole settings;
  - Set `CMD + V` to Paste;
