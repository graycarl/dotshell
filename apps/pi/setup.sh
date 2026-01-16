#!/bin/bash

# Make link from ~/.pi/agent/skills to agent/skills

mkdir -p ~/.pi/agent
ln -s $(pwd)/agent/skills ~/.pi/agent/skills
