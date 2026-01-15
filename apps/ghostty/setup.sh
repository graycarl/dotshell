#!/bin/bash

# make a link from ~/.config/ghostty/config -> ./config

mkdir -p ~/.config/ghostty
ln -s $(pwd)/config ~/.config/ghostty/config
