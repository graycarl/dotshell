# {{app_name}} 命令行构建封装（agent / 开发者使用）
# 底层调用 DevEco Studio 内置工具链（hvigor + JBR），无需打开 IDE
#
# 若本机 DevEco Studio 不在 /Applications/DevEco-Studio.app，改下面三个路径即可

DEVECO_APP := /Applications/DevEco-Studio.app
DEVECO_SDK := $(DEVECO_APP)/Contents/sdk
JBR_HOME   := $(DEVECO_APP)/Contents/jbr/Contents/Home
HVIGOR_BIN := $(DEVECO_APP)/Contents/tools/hvigor/bin
OHPM_BIN   := $(DEVECO_APP)/Contents/tools/ohpm/bin
HVIGOR     := $(HVIGOR_BIN)/hvigorw   # 绝对路径：make 对简单命令跳过 shell 直接 exec，用不到导出后的 PATH

export DEVECO_SDK_HOME := $(DEVECO_SDK)
export JAVA_HOME := $(JBR_HOME)
export PATH := $(OHPM_BIN):$(HVIGOR_BIN):$(PATH)

HVIGOR_FLAGS := --mode module -p product=default -p buildMode=debug --no-daemon

.PHONY: build test clean commit help

build: ## 编译 + 打包 debug HAP（未签名，产物在 entry/build/default/outputs/）
	$(HVIGOR) assembleHap $(HVIGOR_FLAGS)

test: ## 跑 LocalUnit 单测（hypium，entry/src/test）
	$(HVIGOR) test $(HVIGOR_FLAGS)

clean: ## 清理构建产物
	rm -rf entry/build

commit: ## git 提交全部改动（用法：make commit MSG="提交信息"）
	@test -n "$(MSG)" || (echo '用法：make commit MSG="提交信息"'; exit 1)
	git add -A && git commit -m "$(MSG)"

help: ## 列出可用目标
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-8s\033[0m %s\n", $$1, $$2}'
