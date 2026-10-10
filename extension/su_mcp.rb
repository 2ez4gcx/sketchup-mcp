# SU MCP Bridge - loader
# Lets Claude (via the MCP server - a Claude Desktop .mcpb extension) control SketchUp over a localhost socket.
require 'sketchup.rb'
require 'extensions.rb'

module KhuongDoan
  module SuMcp
    PLUGIN_ID = 'su_mcp'.freeze

    unless file_loaded?(__FILE__)
      ext = SketchupExtension.new('SU MCP Bridge', File.join(File.dirname(__FILE__), PLUGIN_ID, 'main'))
      ext.description = 'MCP bridge: lets Claude read, model, run Ruby and export images in SketchUp (127.0.0.1:9876).'
      ext.version     = '1.2.0'
      ext.creator     = 'Khuong Doan'
      Sketchup.register_extension(ext, true)
      file_loaded(__FILE__)
    end
  end
end
