# Install a Ubuntu Desktop in Multipass

First, install remote-desktop client on macOS.

```
brew install microsoft-remote-desktop
```

Then, launch the mulitpass instance:

```
multipass launch -c 2 -m 8G -d 20G -n desktop --cloud-init .shell/apps/multipass/desktop-init.yml
```
